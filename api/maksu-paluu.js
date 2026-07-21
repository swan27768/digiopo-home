// DigiOpo – Paytrail-maksun paluu (selain)
// GET /api/maksu-paluu?checkout-...=...&signature=...
//
// Tänne Paytrail ohjaa OSTAJAN SELAIMEN maksun jälkeen (redirectUrls). Sekä
// onnistunut että peruttu maksu palaavat tänne – ero luetaan checkout-status-
// parametrista. Vahvistus käsitellään jaetussa logiikassa (idempotentti
// callbackin kanssa), minkä jälkeen ostaja ohjataan ihmisluettavalle
// kiitos-/peruutussivulle.
//
// HUOM: emme luota pelkkään selaimen paluuseen lisenssin luonnissa – ostaja voi
// sulkea välilehden ennen paluuta. Sama vahvistus tulee myös palvelinkutsuna
// (api/maksu-callback.js), joka on luotettava. Kumpi tahansa täyttää tilauksen.

import { kasitteleMaksuVahvistus } from './_lib/maksu-kasittely.js';

export default async function handler(req, res) {
  // Query-parametrit toimivat sekä GET- että (varmuuden vuoksi) POST-kutsussa.
  const query = req.query || {};

  let tulos;
  try {
    tulos = await kasitteleMaksuVahvistus(query);
  } catch (err) {
    console.error('maksu-paluu käsittely kaatui:', err.message);
    tulos = { tila: 'virhe' };
  }

  // Kartoita sisäinen tila käyttäjälle näytettävään sivuparametriin.
  let sivutila;
  if (tulos.tila === 'ok' || tulos.tila === 'jo_kasitelty') sivutila = 'ok';
  else if (tulos.tila === 'peruttu') sivutila = 'peru';
  else sivutila = 'virhe';

  res.setHeader('Location', `/tilaus-valmis.html?tila=${sivutila}`);
  return res.status(302).end();
}
