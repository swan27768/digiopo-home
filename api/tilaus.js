// DigiOpo – Tilausten automaattinen käsittely
// POST /api/tilaus
// Body: { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisatiedot }
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
  <ol style="line-height:1.8;padding-left:20px;margin-bottom:28px">
    <li>Oppilaat menevät osoitteeseen <strong>app.digiopo.fi</strong></li>
    <li>Syöttävät koulukoodin kirjautumisruutuun</li>
    <li>Pääsevät suoraan sisältöön</li>
  </ol>
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

function sahkoposti_adminille(t, koodi, voimassa_asti) {
  const pvm = new Date(voimassa_asti).toLocaleDateString('fi-FI');
  const rivi = (nimi, arvo) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;color:#3a5a7a;font-size:13px">${nimi}</td><td style="padding:8px 12px;border-bottom:1px solid #eef5fb;font-size:13px">${arvo}</td></tr>`;
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
    ${rivi('Tilaustyyppi', t.tilaustyyppi === 'koululisenssi' ? 'Koululisenssi' : 'Yksittäinen tilaus')}
    ${rivi('Lisätiedot', t.lisatiedot || '–')}
    ${rivi('Generoitu koodi', `<strong style="font-size:18px;letter-spacing:2px">${koodi}</strong>`)}
    ${rivi('Voimassa asti', pvm)}
  </table>
  <p style="font-size:12px;color:#7a9ab5">Lisenssi on tallennettu Supabaseen ja koodi lähetetty tilaajalle automaattisesti.</p>
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

  const { etunimi, sukunimi, email, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisatiedot } = body || {};

  // Validointi
  if (!etunimi?.trim() || !sukunimi?.trim() || !koulu?.trim() || !kunta?.trim() || !oppilasmaara || !email?.trim()) {
    return res.status(400).json({ ok: false, virhe: 'Pakollinen kenttä puuttuu' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, virhe: 'Virheellinen sähköpostiosoite' });
  }

  // Voimassaoloaika: 12 kk
  const voimassa = new Date();
  voimassa.setFullYear(voimassa.getFullYear() + 1);
  const voimassa_asti = voimassa.toISOString().split('T')[0];

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

    await Promise.allSettled([
      laheta_sahkoposti(emailNorm, 'DigiOpo – opettajalisenssisi on aktivoitu', sahkoposti_opettajalle(etunimi, emailNorm, voimassa_asti)),
      ADMIN_EMAIL && laheta_sahkoposti(ADMIN_EMAIL, `Uusi DigiOpo-tilaus: ${koulu}`, sahkoposti_adminille(
        { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisatiedot }, '(opettajalisenssi – ei koodia)', voimassa_asti
      )),
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

    await Promise.allSettled([
      laheta_sahkoposti(emailNorm, 'DigiOpo – koulukoodisi on valmis', sahkoposti_koululle(etunimi, koodi, voimassa_asti)),
      ADMIN_EMAIL && laheta_sahkoposti(ADMIN_EMAIL, `Uusi DigiOpo-tilaus: ${koulu}`, sahkoposti_adminille(
        { etunimi, sukunimi, email: emailNorm, puhelin, koulu, kunta, oppilasmaara, tilaustyyppi, lisatiedot }, koodi, voimassa_asti
      )),
    ]);
  }

  return res.status(200).json({ ok: true });
}