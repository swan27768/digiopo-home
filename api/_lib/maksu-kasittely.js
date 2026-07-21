// DigiOpo Home – Maksun vahvistuksen käsittely (jaettu redirectin ja callbackin kesken)
//
// Paytrail ilmoittaa onnistuneesta maksusta KAHDESTI: selaimen paluu-URLiin
// (api/maksu-paluu.js) ja palvelinkutsuna (api/maksu-callback.js). Molemmat
// kutsuvat tätä funktiota samoilla query-parametreilla. Idempotenssi hoidetaan
// maksut-taulun atomisella tilasiirtymällä, jotta lisenssi luodaan ja
// sähköpostit lähetetään täsmälleen kerran riippumatta siitä kumpi tulee ensin.

import { kirjaaVirhe } from './virhelogi.js';
import { tarkistaPaluuAllekirjoitus } from './paytrail.js';
import { taytaTilaus, seuraavaLaskunumero } from './tilaus-taytto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function base() { return SUPABASE_URL.replace(/\/$/, ''); }
function otsakkeet(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function haeMaksu(stamp) {
  const r = await fetch(
    `${base()}/rest/v1/maksut?stamp=eq.${encodeURIComponent(stamp)}&select=*&limit=1`,
    { headers: otsakkeet() }
  );
  if (!r.ok) throw new Error(`Supabase haeMaksu ${r.status}: ${await r.text()}`);
  const [rivi] = await r.json();
  return rivi || null;
}

// Atominen varaus: siirrä tila 'odottaa' → 'kasittelyssa' VAIN jos se on vielä
// 'odottaa'. Palauttaa varatun rivin tai null, jos joku ehti ensin. Tämä on koko
// idempotenssin ydin: kaksi yhtäaikaista vahvistusta ei voi molemmat voittaa.
async function varaaKasittelyyn(stamp) {
  const r = await fetch(
    `${base()}/rest/v1/maksut?stamp=eq.${encodeURIComponent(stamp)}&tila=eq.odottaa`,
    { method: 'PATCH', headers: otsakkeet({ Prefer: 'return=representation' }), body: JSON.stringify({ tila: 'kasittelyssa' }) }
  );
  if (!r.ok) throw new Error(`Supabase varaaKasittelyyn ${r.status}: ${await r.text()}`);
  const rivit = await r.json();
  return rivit[0] || null;
}

async function paivitaMaksu(stamp, data) {
  const r = await fetch(
    `${base()}/rest/v1/maksut?stamp=eq.${encodeURIComponent(stamp)}`,
    { method: 'PATCH', headers: otsakkeet({ Prefer: 'return=minimal' }), body: JSON.stringify(data) }
  );
  if (!r.ok) throw new Error(`Supabase paivitaMaksu ${r.status}: ${await r.text()}`);
}

// Palauttaa { tila: 'ok' | 'peruttu' | 'virhe' | 'jo_kasitelty', ... }.
//   ok           – maksu vahvistettu, lisenssi luotu (tai oli jo luotu)
//   peruttu      – ostaja perui tai maksu epäonnistui Paytrailissa
//   virhe        – allekirjoitus ei täsmää tai käsittely kaatui
//   jo_kasitelty – tämä maksu on jo täytetty (idempotentti tois-kutsu)
export async function kasitteleMaksuVahvistus(query) {
  // 1. Allekirjoitus. Ilman kelvollista allekirjoitusta pyyntö voi olla väärennös
  //    – ei luoteta mihinkään sen sisältöön.
  if (!tarkistaPaluuAllekirjoitus(query)) {
    return { tila: 'virhe', syy: 'Allekirjoitus ei täsmää' };
  }

  const stamp  = String(query['checkout-stamp'] || '');
  const status = String(query['checkout-status'] || '');
  const transactionId = String(query['checkout-transaction-id'] || '');

  if (!stamp) return { tila: 'virhe', syy: 'stamp puuttuu' };

  // 2. Muu kuin onnistunut maksu (peruttu / epäonnistunut / kesken). Ei luoda
  //    lisenssiä. Merkitään rivi peruntuneeksi vain jos se vielä odottaa.
  if (status !== 'ok') {
    try {
      const rivi = await haeMaksu(stamp);
      if (rivi && rivi.tila === 'odottaa') {
        await paivitaMaksu(stamp, { tila: 'peruttu' });
      }
    } catch (err) {
      await kirjaaVirhe('maksu peruttu-merkinta', err, { stamp, status });
    }
    return { tila: 'peruttu', status };
  }

  // 3. Onnistunut maksu. Onko jo täytetty?
  let rivi;
  try {
    rivi = await haeMaksu(stamp);
  } catch (err) {
    await kirjaaVirhe('maksu haeMaksu', err, { stamp });
    return { tila: 'virhe', syy: 'Tilausta ei voitu hakea' };
  }
  if (!rivi) return { tila: 'virhe', syy: 'Tuntematon maksu' };
  if (rivi.tila === 'maksettu') return { tila: 'jo_kasitelty', koodi: rivi.koodi };

  // 4. Varaa käsittelyyn atomisesti. Jos ei onnistu, joku toinen kutsu käsittelee
  //    parhaillaan – kerromme silti onnistumisesta (lisenssi on tulossa).
  let varattu;
  try {
    varattu = await varaaKasittelyyn(stamp);
  } catch (err) {
    await kirjaaVirhe('maksu varaaKasittelyyn', err, { stamp });
    return { tila: 'virhe', syy: 'Käsittelyvaraus epäonnistui' };
  }
  if (!varattu) {
    // Ei saatu varausta: rivi ei ollut 'odottaa'. Joko toinen kutsu käsittelee
    // (kasittelyssa) tai se on jo maksettu – kummassakin tapauksessa ostajalle
    // näytetään onnistuminen.
    return { tila: 'ok', kesken: true };
  }

  // 5. Varaa laskunumero (tositenumero) ja täytä tilaus: luo lisenssi + lähetä
  //    koodi ja kuitti. Jos tämä kaatuu, palautetaan rivi 'odottaa'-tilaan, jotta
  //    Paytrailin seuraava callback-yritys voi käsitellä sen uudelleen.
  try {
    const laskunumero = await seuraavaLaskunumero();
    const { koodi } = await taytaTilaus(rivi.tilaus, laskunumero);
    await paivitaMaksu(stamp, {
      tila: 'maksettu',
      maksettu_at: new Date().toISOString(),
      koodi,
      laskunumero: String(laskunumero),
      transaction_id: transactionId || rivi.transaction_id || null,
    });
    return { tila: 'ok', koodi };
  } catch (err) {
    console.error('Tilauksen täyttö kaatui:', err.message);
    await kirjaaVirhe('maksu taytto', err, { stamp, koulu: rivi.tilaus?.koulu });
    await paivitaMaksu(stamp, { tila: 'odottaa' }).catch(() => {});
    return { tila: 'virhe', syy: 'Tilauksen täyttö epäonnistui' };
  }
}
