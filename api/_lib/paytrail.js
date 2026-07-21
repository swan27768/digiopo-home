// DigiOpo Home – Paytrail-verkkomaksun apukirjasto
//
// Paytrail Payment API (https://docs.paytrail.com). Kaikki kutsut allekirjoitetaan
// HMAC-SHA256:lla kauppiaan salaisella avaimella. Allekirjoitus lasketaan aina
// samalla tavalla sekä lähtevissä pyynnöissä (otsakkeet + body) että saapuvassa
// maksun vahvistuksessa (query-parametrit) – tämä tiedosto hoitaa molemmat.
//
// Ympäristömuuttujat (Vercel Dashboard → Settings → Environment Variables):
//   PAYTRAIL_MERCHANT_ID   – kauppiastunnus. Testitunnus: 375917
//   PAYTRAIL_SECRET_KEY    – kauppiaan salainen avain. Testiavain: SAIPPUAKAUPPIAS
//
// TESTITUNNUKSET ovat oletuksena, jotta koko putki toimii heti ilman sopimusta.
// Kun oikea Paytrail-kauppiastili on valmis, aseta muuttujat Verceliin ja tee
// Redeploy – koodiin ei tarvitse koskea. ÄLÄ kirjoita oikeaa avainta tähän
// tiedostoon: se päätyisi gittiin ja olisi käytännössä vuotanut.

import crypto from 'node:crypto';

const PAYTRAIL_API = 'https://services.paytrail.com';

// Julkiset testitunnukset (Paytrailin dokumentaatiosta). Turvallisia oletuksia:
// niillä ei voi vastaanottaa oikeaa rahaa, ja maksut ohjautuvat testipankkeihin.
const MERCHANT_ID = process.env.PAYTRAIL_MERCHANT_ID || '375917';
const SECRET_KEY  = process.env.PAYTRAIL_SECRET_KEY  || 'SAIPPUAKAUPPIAS';

export function paytrailTestitunnuksilla() {
  return !process.env.PAYTRAIL_SECRET_KEY;
}

// ─── Allekirjoitus ───────────────────────────────────────────────────────────
//
// Paytrailin sääntö: otetaan kaikki avaimet jotka alkavat "checkout-",
// pienaakkostetaan, järjestetään aakkosjärjestykseen, ja jokainen kirjoitetaan
// muodossa "avain:arvo\n". Perään liitetään pyynnön body TÄSMÄLLEEN sellaisena
// kuin se lähetetään (sama JSON-merkkijono) tai tyhjä merkkijono jos bodya ei ole.
// Tuloksesta lasketaan HMAC-SHA256 ja se heksataan.
//
// Kriittistä: bodyn on oltava PRECIISISTI sama merkkijono joka lähetetään. Siksi
// serialisoimme bodyn kerran ja käytämme samaa merkkijonoa sekä allekirjoituksessa
// että itse pyynnössä – uudelleen-JSON.stringify voisi tuottaa eri välilyönnit.
export function laskeAllekirjoitus(headers, body, secret = SECRET_KEY) {
  const rivit = Object.keys(headers)
    .filter((avain) => avain.toLowerCase().startsWith('checkout-'))
    .sort()
    .map((avain) => `${avain}:${headers[avain]}`);

  const data = [...rivit, body ?? ''].join('\n');
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

// ─── Maksun luonti ───────────────────────────────────────────────────────────
//
// POST /payments. Palauttaa Paytrailin vastauksen, jossa on mm. `href`
// (maksusivun URL johon ostaja ohjataan), `transactionId` ja `providers`
// (yksittäiset maksutapapainikkeet, jos haluaa upottaa ne omalle sivulle).
//
// HUOM: `items` jätetään tarkoituksella pois. Se on Paytrailissa pakollinen vain
// Shop-in-Shop-kaupoille; tavallisessa maksussa riittää `amount`. Näin vältetään
// tuoterivin alv-prosentin ilmoittaminen (palvelun alv on 13,5 %, joka ei ole
// Paytrailin kokonaislukukenttään luonteva) – oma tosite-sähköposti näyttää
// erittelyn joka tapauksessa.
export async function luoMaksu({
  stamp,
  reference,
  summaSentteina,
  email,
  kieli = 'FI',
  redirectUrls,
  callbackUrls,
}) {
  const body = JSON.stringify({
    stamp,
    reference,
    amount: summaSentteina, // sentteinä, kokonaisluku
    currency: 'EUR',
    language: kieli,
    customer: { email },
    redirectUrls,
    callbackUrls,
  });

  const headers = {
    'checkout-account':   MERCHANT_ID,
    'checkout-algorithm': 'sha256',
    'checkout-method':    'POST',
    'checkout-nonce':     crypto.randomUUID(),
    'checkout-timestamp': new Date().toISOString(),
  };

  const signature = laskeAllekirjoitus(headers, body);

  const vastaus = await fetch(`${PAYTRAIL_API}/payments`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      signature,
    },
    body,
  });

  if (!vastaus.ok) {
    const teksti = await vastaus.text();
    throw new Error(`Paytrail ${vastaus.status}: ${teksti}`);
  }

  return vastaus.json();
}

// ─── Maksun vahvistuksen tarkistus ───────────────────────────────────────────
//
// Paytrail palaa (redirect) ja soittaa (callback) samoilla query-parametreilla:
//   checkout-account, checkout-algorithm, checkout-amount, checkout-stamp,
//   checkout-reference, checkout-transaction-id, checkout-status,
//   checkout-provider, signature
//
// Allekirjoitus lasketaan samalla säännöllä kuin lähtevissä pyynnöissä, mutta
// bodya ei ole (tyhjä merkkijono). Vertailu tehdään timing-safe, jottei
// vastausaika paljasta oikean allekirjoituksen merkkejä.
//
// Palauttaa true vain jos allekirjoitus täsmää. Kutsujan on vielä tarkistettava
// että checkout-status === 'ok' ennen kuin tilaus täytetään.
export function tarkistaPaluuAllekirjoitus(query, secret = SECRET_KEY) {
  const saatuAllekirjoitus = String(query.signature || '');
  if (!saatuAllekirjoitus) return false;

  // Vain checkout-*-parametrit (ei 'signature' itse) mukaan laskentaan.
  const headers = {};
  for (const [avain, arvo] of Object.entries(query)) {
    if (avain.toLowerCase().startsWith('checkout-')) headers[avain] = arvo;
  }

  const odotettu = laskeAllekirjoitus(headers, '', secret);

  const a = Buffer.from(odotettu, 'utf8');
  const b = Buffer.from(saatuAllekirjoitus, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
