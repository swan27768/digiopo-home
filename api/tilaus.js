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

// Generoi laskunumeron: VUOSI + satunnainen 4-numero (esim. "20261847")
function generoi_laskunumero() {
  const vuosi = new Date().getFullYear();
  const satunnainen = String(Math.floor(Math.random() * 9000) + 1000); // 1000–9999
  return `${vuosi}${satunnainen}`;
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

async function laheta_sahkoposti(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY puuttuu – sähköposti ohitettu');
    return;
  }
  const vastaus = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: `DigiOpo <${FROM_EMAIL}>`, to: [to], subject, html }),
  });
  if (!vastaus.ok) {
    // Kirjataan virhe mutta ei kaada tilausta – lisenssi on jo luotu
    console.error('Resend-virhe:', await vastaus.text());
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
      <strong>${koulu}</strong>, ${kunta}<br>
      Yhteyshenkilö: ${etunimi} ${sukunimi}<br>
      <span style="color:#3a5a7a">${email}</span>
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

  // Voimassaoloaika: opettajalisenssi ja koululisenssin vuosilisenssi 12 kk,
  // koululisenssin 3 vuoden lisenssi 36 kk
  const kestoVuosina = (tilaustyyppi === 'koululisenssi' && lisenssikausi === '3vuotta') ? 3 : 1;
  const voimassa = new Date();
  voimassa.setFullYear(voimassa.getFullYear() + kestoVuosina);
  const voimassa_asti = voimassa.toISOString().split('T')[0];

  const hintatiedot = laske_hinta(tilaustyyppi, lisenssikausi, oppilasmaara);
  const laskunumero = generoi_laskunumero();
  const erapaiva    = luo_erapaiva();

  const emailNorm = email.trim().toLowerCase();
  const henkilö = `${etunimi.trim()} ${sukunimi.trim()}`;
  let koodi = null;

  if (tilaustyyppi === 'opettajalisenssi') {
    // Opettajalisenssi: ei jaettavaa koodia – email on avain
    try {
      await lisaa_supabaseen({
        koulu: koulu.trim(),
        yhteyshenkilö: henkilö,
        email: emailNorm,
        tyyppi: 'opettaja',
        voimassa_asti,
        aktiivinen: true,
      });
    } catch (err) {
      console.error('Supabase insert epäonnistui:', err.message);
      return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
    }

    const tilausData = { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot };
    await Promise.allSettled([
      laheta_sahkoposti(emailNorm, 'DigiOpo – opettajalisenssisi on aktivoitu', sahkoposti_opettajalle(etunimi, emailNorm, voimassa_asti)),
      laheta_sahkoposti(emailNorm, `DigiOpo – lasku nro ${String(laskunumero).slice(0,4)}-${String(laskunumero).slice(4)}`, sahkoposti_lasku(tilausData, hintatiedot, laskunumero, erapaiva)),
      ADMIN_EMAIL && laheta_sahkoposti(ADMIN_EMAIL, `Uusi DigiOpo-tilaus: ${koulu}`, sahkoposti_adminille(tilausData, '(opettajalisenssi – ei koodia)', voimassa_asti, hintatiedot)),
    ]);
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
          voimassa_asti,
          aktiivinen: true,
        });
        break;
      } catch (err) {
        if (yritys === 2) {
          console.error('Supabase insert epäonnistui:', err.message);
          return res.status(500).json({ ok: false, virhe: 'Palvelinvirhe – yritä uudelleen' });
        }
      }
    }

    const tilausData = { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisenssikausi, lisatiedot };
    await Promise.allSettled([
      laheta_sahkoposti(emailNorm, 'DigiOpo – koulukoodisi on valmis', sahkoposti_koululle(etunimi, koodi, voimassa_asti)),
      laheta_sahkoposti(emailNorm, `DigiOpo – lasku nro ${String(laskunumero).slice(0,4)}-${String(laskunumero).slice(4)}`, sahkoposti_lasku(tilausData, hintatiedot, laskunumero, erapaiva)),
      ADMIN_EMAIL && laheta_sahkoposti(ADMIN_EMAIL, `Uusi DigiOpo-tilaus: ${koulu}`, sahkoposti_adminille(tilausData, koodi, voimassa_asti, hintatiedot)),
    ]);
  }

  return res.status(200).json({ ok: true });
}